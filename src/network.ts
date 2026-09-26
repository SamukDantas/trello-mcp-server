import * as tls from "node:tls";

interface CertificateStore {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
}

// Preserve Node's bundled/extra CAs and add the operating system's trusted CAs.
// Feature detection keeps the server compatible with older Node.js releases.
export function configureSystemCertificateTrust(
  store: CertificateStore = tls as CertificateStore,
): boolean {
  if (!store.getCACertificates || !store.setDefaultCACertificates) return false;
  const certificates = [
    ...store.getCACertificates("default"),
    ...store.getCACertificates("system"),
  ];
  store.setDefaultCACertificates([...new Set(certificates)]);
  return true;
}

const certificateErrors = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export async function requestTrello(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    // Never include the request URL or raw error message: URLs contain credentials.
    const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
    const rawCode = failure?.cause?.code ?? failure?.code;
    const code = typeof rawCode === "string" && /^[A-Z0-9_]+$/.test(rawCode)
      ? rawCode : "NETWORK_ERROR";
    if (certificateErrors.has(code)) {
      throw new Error(`Falha HTTPS ao conectar à API do Trello (${code}). Verifique a cadeia de certificados confiáveis do sistema. Em versões antigas do Node.js, atualize para Node.js 24 LTS ou configure NODE_EXTRA_CA_CERTS com a CA confiável. A validação TLS permanece ativa.`);
    }
    throw new Error(`Falha de conexão com a API do Trello (${code}). Verifique a rede, DNS e proxy.`);
  }
}
