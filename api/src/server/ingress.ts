/**
 * Ingress / deployment-architecture detection for the Iotistic API.
 *
 * Reads environment variables to determine whether the API is running behind a
 * Kubernetes ingress controller (Envoy, NGINX, ALB, Azure AG, …) or is
 * deployed directly and must handle its own TLS.
 */

export interface IngressArchitecture {
  isK8s: boolean;
  ingressType: string;
  behindIngress: boolean;
  tlsTermination: string;
  gatewayAddress?: string;
}

const RUNNING_IN_K8S = process.env.KUBERNETES_SERVICE_HOST !== undefined;

export function detectIngressArchitecture(): IngressArchitecture {
  const EXPLICIT_BEHIND_INGRESS = process.env.HTTPS_BEHIND_INGRESS === 'true';
  const EXPLICIT_DIRECT_HTTPS = process.env.HTTPS_ENABLED === 'true';

  let ingressType = 'unknown';
  let behindIngress = false;
  let gatewayAddress: string | undefined;

  if (RUNNING_IN_K8S) {
    const ingressClass = process.env.INGRESS_CLASS_NAME || 'envoy';
    const gatewayAddr = process.env.GATEWAY_ADDRESS;

    if (ingressClass.toLowerCase().includes('envoy')) {
      ingressType = 'Envoy Gateway';
      gatewayAddress = gatewayAddr;
    } else if (ingressClass.toLowerCase().includes('nginx')) {
      ingressType = 'NGINX Ingress Controller';
      gatewayAddress = gatewayAddr;
    } else if (ingressClass.toLowerCase().includes('alb')) {
      ingressType = 'AWS Application Load Balancer (ALB)';
      gatewayAddress = gatewayAddr;
    } else if (ingressClass.toLowerCase().includes('azure')) {
      ingressType = 'Azure Application Gateway';
      gatewayAddress = gatewayAddr;
    } else {
      ingressType = `Custom: ${ingressClass}`;
      gatewayAddress = gatewayAddr;
    }

    // Determine TLS termination location
    if (EXPLICIT_BEHIND_INGRESS) {
      behindIngress = true;
    } else if (EXPLICIT_DIRECT_HTTPS && !EXPLICIT_BEHIND_INGRESS) {
      behindIngress = false;
    } else {
      // Default: in K8s without explicit HTTPS_ENABLED, assume behind ingress
      behindIngress = !EXPLICIT_DIRECT_HTTPS;
    }
  }

  const tlsTermination = behindIngress
    ? ingressType
    : 'Direct HTTPS (Node.js app layer)';

  return {
    isK8s: RUNNING_IN_K8S,
    ingressType,
    behindIngress,
    tlsTermination,
    gatewayAddress,
  };
}
