/* Inlines game.js into ui-shell.html -> index.html (single self-contained file). */
var fs = require('fs');
var dir = __dirname;
var engine = fs.readFileSync(dir + '/game.js', 'utf8');
var shell = fs.readFileSync(dir + '/ui-shell.html', 'utf8');
var out = shell.replace('/*__ENGINE__*/', function () { return '\n' + engine + '\n'; });
fs.writeFileSync(dir + '/index.html', out, 'utf8');
console.log('built index.html  (' + out.length + ' bytes)');
