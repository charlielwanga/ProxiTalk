// Disabled pending authentication, explicit consent, rate limits, and a configured SMS provider.
Deno.serve((request: Request) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "content-type": "application/json",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  return new Response(JSON.stringify({
    error: "SMS bridge is disabled until authenticated identity, consent, rate limits, and an SMS provider are configured.",
  }), { status: 503, headers: cors });
});
