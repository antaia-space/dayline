import { findCli } from './cli.mjs';
import { agyStatus, agyEstimate } from './antigravity.mjs';
import { geminiStatus, geminiEstimate } from './gemini.mjs';

// Google moved personal subscription access to Antigravity. Existing seats
// with a usable Gemini Code Assist catalog can keep using the original CLI.
export function createGoogleAdapter({ locate = findCli,
  modern = { status: agyStatus, estimate: agyEstimate },
  legacy = { status: geminiStatus, estimate: geminiEstimate } } = {}) {
  return {
    async status() {
      if (locate('agy')) return { ...await modern.status(), client: 'Antigravity CLI' };
      if (locate('gemini')) {
        const info = await legacy.status();
        if (info.signedIn === true && info.models.length) return { ...info, client: 'Gemini CLI' };
      }
      return { installed: false, signedIn: false, models: [], client: 'Antigravity CLI',
        detail: 'Install Antigravity CLI and sign in with Google to use your personal Google AI subscription. An eligible signed-in Gemini Code Assist CLI is also supported.' };
    },
    async estimate(request) {
      if (locate('agy')) return modern.estimate(request);
      if (locate('gemini')) return legacy.estimate(request);
      throw new Error('Install the official Antigravity CLI and sign in with Google.');
    }
  };
}

export const googleAgent = createGoogleAdapter();
