// fsutil.js — escrita atômica de arquivos JSON (evita corromper o arquivo
// se o processo cair no meio da gravação: escreve num .tmp e troca o nome).
const fs = require('fs');

function atomicWriteFileSync(file, data) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file); // rename é atômico no mesmo volume
}

module.exports = { atomicWriteFileSync };
