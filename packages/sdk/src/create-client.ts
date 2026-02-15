import { AppServerClient, type AppServerClientOptions } from "./app-server-client";
import { getProvider, type ProviderConfig } from "./providers";

export type CreateClientOptions = ({ provider: string } & ProviderConfig) | AppServerClientOptions;

export function createClient(options: CreateClientOptions): AppServerClient {
  if ("provider" in options) {
    const { provider, ...config } = options;
    const resolved = getProvider(provider).resolve(config);
    return new AppServerClient(resolved);
  }
  return new AppServerClient(options);
}
