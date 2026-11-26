import * as bcrypt from 'bcrypt';
import * as mongoose from 'mongoose';
import * as readline from 'node:readline';
import { Role } from '../common/roles';
import { User, UserSchema } from '../users/user.schema';

const roleLabels: Record<Role, string> = {
  [Role.ADMIN_SPI]: 'Administrator SPI',
  [Role.ANGGOTA_SPI]: 'Anggota SPI',
  [Role.PIMPINAN_SPI]: 'Pimpinan SPI',
};

const seedAccounts: Array<{ role: Role; name: string; email: string }> = [
  { role: Role.ADMIN_SPI, name: 'Administrator SPI', email: 'admin.spi@example.com' },
  { role: Role.ANGGOTA_SPI, name: 'Anggota SPI', email: 'anggota.spi@example.com' },
  { role: Role.PIMPINAN_SPI, name: 'Pimpinan SPI', email: 'pimpinan.spi@example.com' },
];

const input = readline.createInterface({ input: process.stdin, output: process.stdout });
const database = new mongoose.Mongoose();

function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Seeder password perlu dijalankan dari terminal interaktif.'));
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          reject(new Error('Seeder dibatalkan.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ' && character !== '\u007f') {
          value += character;
          process.stdout.write('*');
        }
      }
    };

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI belum diatur. Isi koneksi MongoDB pada backend/.env terlebih dahulu.');

  await database.connect(uri);
  const UserModel = database.model(User.name, UserSchema);
  console.log('\nSeeder akun SPI. Satu password akan digunakan untuk seluruh akun seed.');
  const password = await askHidden('Password bersama (minimal 8 karakter): ');
  if (password.length < 8) throw new Error('Password harus memiliki minimal 8 karakter.');
  const passwordHash = await bcrypt.hash(password, 12);

  const existingByRole = new Map<Role, { email: string } | null>();
  for (const account of seedAccounts) {
    const existing = await UserModel.findOne({ role: account.role }).select('email').lean();
    existingByRole.set(account.role, existing ? { email: existing.email } : null);
    if (!existing && await UserModel.exists({ email: account.email })) {
      throw new Error(`Email seed ${account.email} sudah dipakai akun lain. Ubah email tersebut pada src/seeders/seed-users.ts.`);
    }
  }

  for (const account of seedAccounts) {
    const existing = existingByRole.get(account.role);
    if (existing && existing.email !== account.email) {
      console.log(`${roleLabels[account.role]} dilewati: sudah ada akun dengan email berbeda (${existing.email}).`);
      continue;
    }

    if (existing) {
      await UserModel.updateOne({ role: account.role, email: account.email }, { $set: { passwordHash, active: true } });
      console.log(`Password akun ${roleLabels[account.role]} diperbarui: ${account.email}.`);
    } else {
      await UserModel.create({ ...account, passwordHash, active: true });
      console.log(`Akun ${roleLabels[account.role]} dibuat: ${account.email}.`);
    }
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan saat membuat akun.';
    console.error(`Seeder gagal: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    input.close();
    await database.disconnect();
  });
