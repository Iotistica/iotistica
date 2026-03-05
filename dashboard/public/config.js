// Runtime configuration - will be replaced by Kubernetes ConfigMap
// DO NOT EDIT - This file is a template for K8s deployments
// For local development, these values will be read from .env file via import.meta.env fallback
window.env = {
  VITE_API_URL: '__VITE_API_URL__',
  
  // Auth0 Configuration
  VITE_AUTH0_DOMAIN: '__VITE_AUTH0_DOMAIN__',
  VITE_AUTH0_CLIENT_ID: '__VITE_AUTH0_CLIENT_ID__',
  VITE_AUTH0_AUDIENCE: '__VITE_AUTH0_AUDIENCE__',
  VITE_AUTH0_CALLBACK_URL: '__VITE_AUTH0_CALLBACK_URL__',
  VITE_AUTH0_SHOW_SOCIAL_LOGIN: '__VITE_AUTH0_SHOW_SOCIAL_LOGIN__',
  
  // Provisioning API
  VITE_PROVISIONING_API_URL: '__VITE_PROVISIONING_API_URL__',
  
  // Website URL
  VITE_WEBSITE_URL: '__VITE_WEBSITE_URL__',
  
  NODE_ENV: '__NODE_ENV__'
};
