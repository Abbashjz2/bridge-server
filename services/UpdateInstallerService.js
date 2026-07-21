class UpdateInstallerService {
  constructor() {
    this.url = process.env.UPDATE_AGENT_URL;
    this.secret = process.env.UPDATE_AGENT_SECRET;
    this.timeout = Number(process.env.UPDATE_AGENT_TIMEOUT_MS || 10000);

    if (!this.url) {
      throw new Error("UPDATE_AGENT_URL is not configured");
    }

    if (!this.secret) {
      throw new Error("UPDATE_AGENT_SECRET is not configured");
    }
  }

  async install(version) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.url}/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-update-secret": this.secret,
        },
        body: JSON.stringify({ version }),
        signal: controller.signal,
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = UpdateInstallerService;
