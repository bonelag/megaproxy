/**
 * `POST /api/chat/completions` — the GUI Chat tab's relay into the normal
 * routing pipeline.
 *
 * Why a management-plane route instead of pointing the GUI at
 * `/v1/chat/completions`: the data plane gates on `resolveResponsesApiAuth`,
 * which only auto-admits on a loopback hostname and otherwise demands
 * `x-opencodex-api-key`. The GUI's fetch wrapper (gui/src/api.ts) attaches its
 * credential to `/api/*` ONLY, by design — the admin/session token is a
 * management credential and must never be spent as a data-plane secret. So a
 * dashboard served from a non-loopback host could not chat at all, and hacking
 * the data-plane key into the browser would be the wrong fix.
 *
 * The trade this route makes explicit: the chat surface is authorized by
 * MANAGEMENT auth (admin token or a minted GUI session, already validated
 * before dispatch), not by a data-plane API key. Anyone who can reach the
 * dashboard can already read/write providers and credentials, so also being
 * able to spend a turn is not a new capability. Nothing here weakens the
 * data plane: `/v1/*` keeps its own gate untouched.
 *
 * Everything after admission is the ordinary path — the same
 * `handleChatCompletions` translate-and-replay that `/v1/chat/completions`
 * uses, so routing, provider headers, pools, sidecars, usage and `/api/logs`
 * all behave identically to a real client turn.
 */
import { jsonResponse } from "../auth-cors";
import { isDraining, tryAdmitTurn } from "../lifecycle";
import { handleChatCompletions } from "../chat-completions";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "../request-log";
import type { ManagementContext } from "./context";

/** Headers the relay refuses to pass into the pipeline. */
const STRIPPED_INBOUND_HEADERS = [
  // Management credentials are not data-plane secrets and must not be forwarded
  // upstream by the FORWARD_HEADERS pass inside handleChatCompletions.
  "authorization",
  "x-opencodex-api-key",
  "x-opencodex-csrf-token",
  "x-opencodex-gui-origin",
  "cookie",
  // Surface attribution is a server-side decision, not a client claim.
  "x-opencodex-grok",
];

export async function handleChatRelayRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/chat/completions" || req.method !== "POST") return null;

  if (isDraining()) {
    const response = jsonResponse(
      { error: { message: "proxy is draining", type: "server_error", code: "draining" } },
      503,
      req,
      config,
    );
    response.headers.set("Retry-After", "1");
    return response;
  }

  const lease = tryAdmitTurn();
  if (!lease) {
    const response = jsonResponse(
      { error: { message: "server busy: active turns", type: "server_error", code: "server_busy" } },
      503,
      req,
      config,
    );
    response.headers.set("Retry-After", "1");
    return response;
  }

  // Rebuild the request so the pipeline sees a clean data-plane-shaped POST:
  // same body and content negotiation, none of the management credentials, and
  // the `/v1/chat/completions` URL the downstream code documents itself against.
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (STRIPPED_INBOUND_HEADERS.includes(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const innerReq = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: req.body,
    // Bun requires this for a streamed request body.
    ...({ duplex: "half" } as Record<string, unknown>),
    signal: req.signal,
  });

  const start = Date.now();
  const requestId = nextRequestLogId(start);
  const logCtx: RequestLogContext = {
    model: "unknown",
    provider: "unknown",
    // The GUI relay is admitted by management auth; there is no data-plane key
    // to attribute, and `loopback` is the existing "no configured key" kind.
    admissionKind: "loopback",
    inboundProtocol: "chat",
  };

  let response: Response;
  try {
    response = await handleChatCompletions(innerReq, config, logCtx, { requestId, start, turnAdmissionLease: lease });
  } catch (error) {
    lease.release();
    addFinalRequestLog(requestId, start, logCtx, 500, { closeReason: "non_stream" });
    return jsonResponse(
      {
        error: {
          message: error instanceof Error && error.message ? error.message : "chat relay failed",
          type: "server_error",
          code: null,
        },
      },
      500,
      req,
      config,
    );
  }
  if (!lease.isTransferred()) lease.release();
  return response;
}
