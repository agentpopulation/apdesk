import test from 'node:test';
import assert from 'node:assert/strict';
import { fit, cleanPost } from './server.js';
import { oauth1Header, NETWORKS } from './networks.js';

test('fit cuts a post to the network limit at a sentence or word end', () => {
  const long = 'One short line. ' + 'word '.repeat(100);
  const f = fit(long, NETWORKS.x.limit);
  assert.ok(f.cut && f.text.length <= 280);
  assert.deepEqual(fit('short', 280), { text: 'short', cut: false });
});
test('cleanPost strips preambles, quotes and code fences', () => {
  assert.equal(cleanPost('Here is your post:\n\n"Hello world"'), 'Hello world');
  assert.equal(cleanPost('```\nHi\n```'), 'Hi');
});
test('OAuth 1.0a signature matches the published X example', () => {
  const status = 'Hello Ladies + Gentlemen, a signed OAuth request!';
  const header = oauth1Header({ method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=' + encodeURIComponent(status),
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 });
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});
