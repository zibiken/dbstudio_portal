import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

export const RP_ID = 'portal.dbstudio.one';
export const RP_NAME = 'DB Studio Portal';
export const ORIGIN = `https://${RP_ID}`;

function uuidStringToBytes(uuid) {
  return new Uint8Array(uuid.replace(/-/g, '').match(/.{2}/g).map(h => parseInt(h, 16)));
}

export async function beginRegistration({ userID, userName, userDisplayName, existingCredentials = [] }) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: uuidStringToBytes(userID),
    userName,
    userDisplayName,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map(c => ({
      id: c.id,
      transports: c.transports ?? ['internal'],
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });
}

export async function finishRegistration({ response, expectedChallenge }) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
}

export async function beginAuthentication({ userCredentials = [] }) {
  return generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: userCredentials.map(c => ({
      id: c.id,
      transports: c.transports ?? ['internal'],
    })),
  });
}

export async function finishAuthentication({ response, expectedChallenge, credential }) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential,
  });
}

export function saveRegisteredCredential(existing, registrationInfo) {
  return [
    ...existing,
    {
      id: registrationInfo.credentialID,
      publicKey: registrationInfo.credentialPublicKey,
      counter: registrationInfo.counter,
      transports: registrationInfo.transports ?? ['internal'],
      registeredAt: new Date().toISOString(),
    },
  ];
}

export function removeCredential(existing, credentialId) {
  return existing.filter(c => c.id !== credentialId);
}
