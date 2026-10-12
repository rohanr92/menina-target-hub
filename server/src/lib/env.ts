// Environment configuration. Only infrastructure secrets live here;
// marketplace API keys are entered in the app and stored encrypted in the DB.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  encryptionKey: required('ENCRYPTION_KEY'),
  appPassword: required('APP_PASSWORD'),
  port: Number(process.env.PORT ?? 8080),
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''), // e.g. https://menina-target-hub.up.railway.app
  disableJobs: process.env.DISABLE_JOBS === '1',
  isProd: process.env.NODE_ENV === 'production',
};
