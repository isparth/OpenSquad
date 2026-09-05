/** Main-process configuration. Env vars are read here only; the renderer asks over IPC. */
export const config = {
  apiBaseUrl: process.env.OPENSQUAD_API_URL ?? "http://localhost:3000",
};
