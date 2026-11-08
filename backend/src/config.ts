export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  emailDriver: 'log' | 'memory';
  staffSessionHours: number;
}

export function loadConfig(env = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const jwtSecret = env.JWT_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!jwtSecret || jwtSecret.length < 16) throw new Error('JWT_SECRET must be at least 16 characters');
  return {
    databaseUrl,
    jwtSecret,
    emailDriver: env.EMAIL_DRIVER === 'memory' ? 'memory' : 'log',
    staffSessionHours: 8,
  };
}
