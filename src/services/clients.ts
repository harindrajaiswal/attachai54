import crypto from 'node:crypto';
import type { Repository } from '../repositories/repository.js';
import type { ObjectStorage } from '../providers/storage.js';
import type { VectorProvider } from '../providers/vector.js';
import type { ClientConfig } from '../domain/types.js';
import { generateApiKey, hashKey, normalizeDomain } from '../lib/security.js';
export class ClientService {
  constructor(
    private repo: Repository,
    private storage: ObjectStorage,
    private vectors: VectorProvider,
    private baseUrl: string,
  ) {}
  private credentials(apiKey: string) {
    const widgetUrl = new URL('/widget.js', this.baseUrl).toString();
    return {
      apiKey,
      embedCode: `<script src="${widgetUrl}" data-api-key="${apiKey}" async></script>`,
      copyOnce: true as const,
    };
  }
  async create(v: {
    name: string;
    slug: string;
    domains: string[];
    config: ClientConfig;
    prompt: string;
  }) {
    const id = crypto.randomUUID(),
      apiKey = generateApiKey();
    const client = await this.repo.createClient({
      ...v,
      id,
      domains: v.domains.map(normalizeDomain),
      keyHash: hashKey(apiKey),
    });
    await this.repo.audit(id, 'client.created', { slug: v.slug });
    return { client, ...this.credentials(apiKey) };
  }
  async rotate(id: string) {
    if (!(await this.repo.getClient(id))) return;
    const apiKey = generateApiKey();
    await this.repo.rotateKey(id, hashKey(apiKey));
    await this.repo.audit(id, 'key.rotated', {});
    return this.credentials(apiKey);
  }
  async remove(id: string) {
    const ok = await this.repo.deleteClient(id);
    if (ok) {
      await this.storage.removeTenant(id);
      await this.vectors.deleteTenant(id);
    }
    return ok;
  }
}
