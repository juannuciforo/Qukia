const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, email, newPassword] = process.argv;

  if (!email || !newPassword) {
    console.error('\nUso: npm run db:reset-pass -- email@ejemplo.com nuevapass123\n');
    process.exit(1);
  }

  const user = await p.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (!user) {
    console.error('\nUsuario no encontrado: ' + email + '\n');
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await p.user.update({ where: { id: user.id }, data: { passwordHash: hash } });

  console.log('\nContrasena actualizada para: ' + user.email + ' (' + user.role + ')\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());