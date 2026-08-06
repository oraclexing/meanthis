export interface OriginScope {
  origin: string;
  redactedUrl: string;
  redactedFields: string[];
}

export function createOriginScope(pageUrl: string): OriginScope {
  const url = new URL(pageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ui-attach extension capture only supports http(s) pages");
  }

  const redactedFields: string[] = [];
  if (url.search || url.hash) {
    redactedFields.push("source.url");
    url.search = "";
    url.hash = "";
  }

  return {
    origin: url.origin,
    redactedUrl: url.toString(),
    redactedFields,
  };
}
