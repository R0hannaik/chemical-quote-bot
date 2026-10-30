// Usage: npm run create-user -- "Name" email@example.com owner|operator|viewer 'password'
import { config } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createUser, type Role } from '../web/auth.ts';

const [name, email, role, password] = process.argv.slice(2);
if (!name || !email || !['owner', 'operator', 'viewer'].includes(role) || !password) {
  console.error('Usage: npm run create-user -- "Name" email@example.com owner|operator|viewer \'password\'');
  process.exit(1);
}
const id = await createUser(openDb(config.dbPath), name, email, role as Role, password);
console.log(`Created user ${id}`);
