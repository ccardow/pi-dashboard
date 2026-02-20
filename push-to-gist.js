const fs = require('fs');
const { execSync } = require('child_process');

const vibes = fs.readFileSync(__dirname + '/vibes.json', 'utf8');
const payload = JSON.stringify({
  files: {
    'vibes.json': {
      content: vibes
    }
  }
});

fs.writeFileSync('/tmp/gist-payload.json', payload);

try {
  const result = execSync('gh api -X PATCH /gists/e65c6cfabb1fbc98983381da98801408 --input /tmp/gist-payload.json');
  console.log('Gist updated successfully!');
} catch (err) {
  console.error('Error updating gist:', err.message);
  process.exit(1);
}
