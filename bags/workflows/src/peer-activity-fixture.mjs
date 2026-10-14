export const activities = { "effect@1": async (input, context) => {
  const response = await globalThis.fetch(input.destination, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: context.idempotencyKey, value: input.value }), signal: context.signal });
  if (!response.ok) throw new Error("destination refused effect");
  return response.json();
} };
