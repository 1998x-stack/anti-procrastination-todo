// Global setup for the deployment verification suite.
// Fails fast with an actionable message when the deployed site is not reachable,
// instead of timing out in every test.
const baseURL = process.env.SF_URL || "http://127.0.0.1:8081";

export default async function globalSetup() {
  let response;
  try {
    response = await fetch(baseURL + "/healthz", { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(
      `Deployed site is not reachable at ${baseURL} (${error.message}).\n` +
      `Start it first:  deploy/deploy.sh   # then: deploy/healthcheck.sh`
    );
  }
  if (!response.ok) {
    throw new Error(`Deployed site health probe returned HTTP ${response.status} at ${baseURL}/healthz`);
  }
  const body = (await response.text()).trim();
  if (body !== "ok") throw new Error(`Unexpected /healthz body at ${baseURL}: ${JSON.stringify(body)}`);
  console.log(`[deployed-setup] ${baseURL}/healthz -> ok`);
}
