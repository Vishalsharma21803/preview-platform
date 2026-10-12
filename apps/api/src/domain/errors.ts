const publicMessages = new Set([
  "deployment failed", "preview health check failed", "deployment superseded or cancelled",
  "deployment lease lost", "image pull failed", "runtime operation failed", "route operation failed",
  "image declares volumes", "runtime container missing", "runtime container stopped",
]);

/** Only fixed messages cross the persistence/public API boundary. */
export function publicDeploymentError(message: string): string {
  return publicMessages.has(message) ? message : "deployment failed";
}
