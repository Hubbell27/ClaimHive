/**
 * Deployment environment. Fails closed: a production Node build is treated as a
 * real deployment unless APP_ENV explicitly says "local" (smoke-testing a
 * production build on a developer machine with synthetic data only).
 */
export function isRealDeployment(): boolean {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production" || appEnv === "staging") return true;
  if (appEnv === "local" || appEnv === "test") return false;
  return process.env.NODE_ENV === "production";
}
