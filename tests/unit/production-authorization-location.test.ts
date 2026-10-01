import { describe, it, expect } from 'vitest';
import {
  productionAuthorizationLocation,
  productionApplicationLocation,
} from '../../apps/api/src/production-authorization-location.js';

describe('authorization callback follows the configured application', () => {
  it('keeps the default local installation and follows another API port', () => {
    expect(productionAuthorizationLocation({})).toBe(
      'http://127.0.0.1:4310/v1/connections/production-pilot/callback',
    );
    expect(productionAuthorizationLocation({ API_PORT: '4430', WEB_PORT: '5273' })).toBe(
      'http://127.0.0.1:4430/v1/connections/production-pilot/callback',
    );
  });
  it('uses HTTPS API and UI origins on the same cookie host', () => {
    expect(
      productionAuthorizationLocation({
        PUBLIC_API_ORIGIN: 'https://uploader.example.test',
        PUBLIC_WEB_ORIGIN: 'https://uploader.example.test',
      }),
    ).toBe('https://uploader.example.test/v1/connections/production-pilot/callback');
  });
  it('accepts an explicit root callback on the configured UI host', () => {
    expect(
      productionAuthorizationLocation({
        PUBLIC_WEB_ORIGIN: 'https://uploader.example.test',
        SHOPEE_AUTHORIZATION_CALLBACK_URL:
          'https://uploader.example.test/v1/connections/production-pilot/callback',
      }),
    ).toBe('https://uploader.example.test/v1/connections/production-pilot/callback');
  });
  it('keeps different HTTPS ports on the same cookie host', () => {
    expect(
      productionAuthorizationLocation({
        PUBLIC_API_ORIGIN: 'https://uploader.example.test:4430',
        PUBLIC_WEB_ORIGIN: 'https://uploader.example.test:5273',
      }),
    ).toBe('https://uploader.example.test:4430/v1/connections/production-pilot/callback');
  });
  it.each([
    { API_PORT: 'not-a-port' },
    { PUBLIC_API_ORIGIN: 'http://uploader.example.test' },
    { PUBLIC_API_ORIGIN: 'https://user:pass@uploader.example.test' },
    { PUBLIC_API_ORIGIN: 'https://uploader.example.test?redirect=other' },
    { SHOPEE_AUTHORIZATION_CALLBACK_URL: 'https://uploader.example.test/other' },
    {
      SHOPEE_AUTHORIZATION_CALLBACK_URL:
        'https://uploader.example.test/v1/connections/production-pilot/callback#code',
    },
  ])('refuses ambiguous or unsafe configuration %j', (env) => {
    expect(() => productionAuthorizationLocation(env)).toThrow(
      'AUTHORIZATION_CALLBACK_CONFIGURATION_INVALID',
    );
  });
  it.each([
    {
      PUBLIC_WEB_ORIGIN: 'https://uploader.example.test',
      SHOPEE_AUTHORIZATION_CALLBACK_URL:
        'https://uploader.example.test/app/v1/connections/production-pilot/callback',
    },
    {
      PUBLIC_API_ORIGIN: 'https://api.example.test',
      PUBLIC_WEB_ORIGIN: 'https://listing.example.test',
    },
    {
      PUBLIC_WEB_ORIGIN: 'https://listing.example.test',
      SHOPEE_AUTHORIZATION_CALLBACK_URL:
        'https://uploader.example.test/v1/connections/production-pilot/callback',
    },
    { PUBLIC_API_ORIGIN: 'http://localhost:4430', WEB_PORT: '5273' },
    {
      PUBLIC_API_ORIGIN: 'https://127.0.0.1:4430',
      PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5273',
    },
    {
      PUBLIC_API_ORIGIN: 'http://127.0.0.1:4430',
      PUBLIC_WEB_ORIGIN: 'https://127.0.0.1:5273',
    },
  ])('refuses callback configurations that lose the browser cookie %j', (env) => {
    expect(() => productionAuthorizationLocation(env)).toThrow(
      'AUTHORIZATION_CALLBACK_CONFIGURATION_INVALID',
    );
  });
});

describe('authorization returns to the configured UI', () => {
  it('keeps the local default and a distinct review UI port', () => {
    expect(productionApplicationLocation({})).toBe('http://127.0.0.1:5173/');
    expect(productionApplicationLocation({ WEB_PORT: '5273' })).toBe('http://127.0.0.1:5273/');
    expect(
      productionApplicationLocation({ PUBLIC_WEB_ORIGIN: 'https://listing.example.test' }),
    ).toBe('https://listing.example.test/');
  });
  it.each([
    { WEB_PORT: '0' },
    { WEB_PORT: '65536' },
    { WEB_PORT: 'no-port' },
    { PUBLIC_WEB_ORIGIN: 'http://listing.example.test' },
    { PUBLIC_WEB_ORIGIN: 'https://user:pass@listing.example.test' },
    { PUBLIC_WEB_ORIGIN: 'https://listing.example.test/path' },
    { PUBLIC_WEB_ORIGIN: 'https://listing.example.test?code=x' },
  ])('refuses an unsafe or ambiguous application origin %j', (env) => {
    expect(() => productionApplicationLocation(env)).toThrow(
      'AUTHORIZATION_APPLICATION_CONFIGURATION_INVALID',
    );
  });
});
