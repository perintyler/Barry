/**
 * Mask a secret for display (shows first 7 and last 3 characters)
 * Example: sk-ant-abc123...xyz
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 10) {
    return '***';
  }
  return `${secret.slice(0, 7)}...${secret.slice(-3)}`;
}
