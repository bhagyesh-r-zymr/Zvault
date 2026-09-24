import { describe, expect, it } from 'vitest';
import { parseProof, recoveryCodesFile } from './proof.js';

describe('parseProof', () => {
  it('reads six-digit codes with spaces', () => {
    expect(parseProof('123 456', 'code')).toEqual({ code: '123456' });
    expect(parseProof('12345', 'code')).toBeNull();
  });

  it('reads recovery codes in any case', () => {
    expect(parseProof('abcde-fghjk', 'recovery')).toEqual({ recoveryCode: 'ABCDE-FGHJK' });
    expect(parseProof('123456', 'recovery')).toBeNull();
  });
});

describe('recoveryCodesFile', () => {
  it('lists every code', () => {
    const text = recoveryCodesFile(['AAAAA-BBBBB', 'CCCCC-DDDDD'], 'ada@example.com');
    expect(text).toContain('AAAAA-BBBBB\nCCCCC-DDDDD');
    expect(text).toContain('ada@example.com');
  });
});
