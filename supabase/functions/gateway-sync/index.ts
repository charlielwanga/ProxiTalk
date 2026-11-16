// Disabled pending authenticated identities and packet-scoped authorization.
Deno.serve((request: Request) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "content-type": "application/json",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  return new Response(JSON.stringify({
    error: "Cloud sync is disabled until authenticated identity, scoped RLS policies, and packet authorization are implemented.",
  }), { status: 503, headers: cors });
});
