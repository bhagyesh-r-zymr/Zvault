import { RecoveryCode, TotpCode, type TwoFactorProof } from '@zvault/shared';

/** Turns what the user typed into a proof, or null if it isn't well-formed yet. */
export function parseProof(input: string, mode: 'code' | 'recovery'): TwoFactorProof | null {
  if (mode === 'code') {
    const code = TotpCode.safeParse(input);
    return code.success ? { code: code.data } : null;
  }
  const recoveryCode = RecoveryCode.safeParse(input);
  return recoveryCode.success ? { recoveryCode: recoveryCode.data } : null;
}

/** Plain-text file offered for download next to the recovery codes. */
export function recoveryCodesFile(codes: readonly string[], account: string): string {
  return [
    'Zvault recovery codes',
    `Account: ${account}`,
    '',
    'Each code works once if you lose your authenticator. Keep them somewhere safe and offline.',
    '',
    ...codes,
    '',
  ].join('\n');
}
