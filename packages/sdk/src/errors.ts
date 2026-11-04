export class OboroError extends Error {
  constructor(public readonly code: string, message: string, public readonly paid = false) {
    super(message);
    this.name = 'OboroError';
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new OboroError('setup_required', `Setup required: ${name}`);
  return value;
}
