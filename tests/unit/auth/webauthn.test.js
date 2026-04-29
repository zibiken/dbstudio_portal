import { describe, it, expect } from 'vitest';
import {
  beginRegistration,
  beginAuthentication,
  saveRegisteredCredential,
  removeCredential,
  RP_ID,
  RP_NAME,
} from '../../../lib/auth/webauthn.js';

describe('webauthn', () => {
  it('exposes the relying-party identity', () => {
    expect(RP_ID).toBe('portal.dbstudio.one');
    expect(RP_NAME).toBe('DB Studio Portal');
  });

  describe('beginRegistration', () => {
    it('returns options with a challenge and user info, requires platform authenticator', async () => {
      const opts = await beginRegistration({
        userID: '0190f9c4-89d3-7777-8888-aaaaaaaaaaaa',
        userName: 'admin@example.com',
        userDisplayName: 'Admin Example',
        existingCredentials: [],
      });
      expect(typeof opts.challenge).toBe('string');
      expect(opts.challenge.length).toBeGreaterThan(0);
      expect(opts.rp.id).toBe('portal.dbstudio.one');
      expect(opts.rp.name).toBe('DB Studio Portal');
      expect(opts.user.name).toBe('admin@example.com');
      expect(opts.user.displayName).toBe('Admin Example');
      expect(opts.authenticatorSelection?.authenticatorAttachment).toBe('platform');
      expect(opts.authenticatorSelection?.userVerification).toBe('required');
    });

    it('passes existingCredentials into excludeCredentials so they cannot re-enrol', async () => {
      const existing = [
        { id: 'AAAAAAA', publicKey: 'pk', counter: 0, transports: ['internal'] },
        { id: 'BBBBBBB', publicKey: 'pk2', counter: 1 },
      ];
      const opts = await beginRegistration({
        userID: '0190f9c4-89d3-7777-8888-aaaaaaaaaaaa',
        userName: 'a@b',
        userDisplayName: 'A',
        existingCredentials: existing,
      });
      expect(opts.excludeCredentials).toHaveLength(2);
      expect(opts.excludeCredentials.map(c => c.id)).toEqual(['AAAAAAA', 'BBBBBBB']);
    });
  });

  describe('beginAuthentication', () => {
    it('returns options with a challenge and allowCredentials drawn from the user\'s creds', async () => {
      const creds = [
        { id: 'AAAAAAA', publicKey: 'pk', counter: 5, transports: ['internal'] },
      ];
      const opts = await beginAuthentication({ userCredentials: creds });
      expect(typeof opts.challenge).toBe('string');
      expect(opts.rpId).toBe('portal.dbstudio.one');
      expect(opts.userVerification).toBe('required');
      expect(opts.allowCredentials).toHaveLength(1);
      expect(opts.allowCredentials[0].id).toBe('AAAAAAA');
    });
  });

  describe('saveRegisteredCredential', () => {
    it('appends a normalized credential row to the array', () => {
      const before = [];
      const after = saveRegisteredCredential(before, {
        credentialID: 'NEW',
        credentialPublicKey: 'pk_new',
        counter: 0,
        transports: ['internal'],
      });
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual({
        id: 'NEW',
        publicKey: 'pk_new',
        counter: 0,
        transports: ['internal'],
        registeredAt: expect.any(String),
      });
    });

    it('does not mutate the input array', () => {
      const before = [];
      const after = saveRegisteredCredential(before, {
        credentialID: 'NEW',
        credentialPublicKey: 'pk',
        counter: 0,
      });
      expect(before).toHaveLength(0);
      expect(after).not.toBe(before);
    });
  });

  describe('removeCredential', () => {
    it('returns the array minus the credential with the given id', () => {
      const creds = [
        { id: 'A', publicKey: 'pkA', counter: 0 },
        { id: 'B', publicKey: 'pkB', counter: 1 },
        { id: 'C', publicKey: 'pkC', counter: 2 },
      ];
      const after = removeCredential(creds, 'B');
      expect(after).toHaveLength(2);
      expect(after.map(c => c.id)).toEqual(['A', 'C']);
    });

    it('returns the same array contents when the id is not present', () => {
      const creds = [{ id: 'A', publicKey: 'pkA', counter: 0 }];
      expect(removeCredential(creds, 'Z')).toEqual(creds);
    });
  });
});
