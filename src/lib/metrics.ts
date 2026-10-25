export class Metrics {
  requests = 0;
  errors = 0;
  totalLatencyMs = 0;
  started = Date.now();
  record(ms: number, status: number) {
    this.requests++;
    this.totalLatencyMs += ms;
    if (status >= 500) this.errors++;
  }
  snapshot() {
    const m = process.memoryUsage();
    return {
      uptimeSeconds: process.uptime(),
      requests: this.requests,
      errors: this.errors,
      averageLatencyMs: this.requests
        ? Math.round((this.totalLatencyMs / this.requests) * 100) / 100
        : 0,
      cpu: process.cpuUsage(),
      memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal },
      startedAt: new Date(this.started).toISOString(),
    };
  }
  prometheus() {
    const s = this.snapshot();
    return `# TYPE app_requests_total counter\napp_requests_total ${s.requests}\n# TYPE app_errors_total counter\napp_errors_total ${s.errors}\n# TYPE app_request_latency_ms gauge\napp_request_latency_ms ${s.averageLatencyMs}\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes ${s.memory.rss}\n`;
  }
}
