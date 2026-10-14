export async function api(url, body) {
  let response;
  try { response = await fetch(url, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (error) { if (body !== undefined) throw new Error("Outcome unknown — retry this same request without changing its ID or input."); throw error; }
  if (response.status === 401) { location.href = "/sign-in"; throw new Error("Your session expired. Sign in again."); }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${body !== undefined && result.retryable ? "Outcome unknown — preserve this request ID. " : ""}${typeof result.error === "string" ? result.error : result.error?.message ?? result.message ?? `Request failed (${response.status})`}`), { status: response.status, code: result.code });
  return result;
}
