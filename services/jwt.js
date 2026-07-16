const fetch = require('node-fetch');

function createJwtService({ config, log }) {
  async function verifyJwt(token) {
    if (!token) {
      return null;
    }

    try {
      const response = await fetch(
        `${config.SUPABASE_URL}/auth/v1/user`,
        {
          headers: {
            apikey: config.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      log(`JWT verification failed: ${error.message}`);
      return null;
    }
  }

  return {
    verifyJwt,
  };
}

module.exports = {
  createJwtService,
};