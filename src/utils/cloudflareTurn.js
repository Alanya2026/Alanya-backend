// Identifiants TURN de Cloudflare, utilisés seulement en repli (voir turnHealth).
//
// Ils se demandent à l'API de Cloudflare : on les garde en cache pour qu'une panne
// de nos serveurs ne se transforme pas en un appel d'API par requête.

const CREDENTIALS_TTL_SEC = 3600;
// Les téléphones gardent la liste quelques minutes : les identifiants doivent
// leur survivre.
const REFRESH_MARGIN_SEC = 600;
const REQUEST_TIMEOUT_MS = 3000;

const createCloudflareTurn = ({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  env = process.env,
} = {}) => {
  let cached = [];
  let refreshAt = 0;

  /** Rend `[]` si Cloudflare n'est pas configuré ou ne répond pas. */
  const getIceServers = async () => {
    const keyId = env.CLOUDFLARE_TURN_KEY_ID;
    const token = env.CLOUDFLARE_TURN_API_TOKEN;
    if (!keyId || !token) return [];
    if (cached.length > 0 && now() < refreshAt) return cached;

    try {
      const response = await fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: CREDENTIALS_TTL_SEC }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`réponse ${response.status}`);
      }
      const data = await response.json();
      const servers = [data.iceServers].flat().filter((s) => s && s.urls);
      if (servers.length === 0) throw new Error('réponse sans serveur');
      cached = servers;
      refreshAt = now() + (CREDENTIALS_TTL_SEC - REFRESH_MARGIN_SEC) * 1000;
    } catch (error) {
      console.error('[TURN] identifiants Cloudflare indisponibles:', error.message);
    }
    return cached;
  };

  return { getIceServers };
};

module.exports = { createCloudflareTurn };
