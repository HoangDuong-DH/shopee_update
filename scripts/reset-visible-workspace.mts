import 'dotenv/config';
import { Pool } from '@shopee/persistence';
import { mkdir, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
  if (process.argv.includes('--apply')) {
    const names = tables.map(row => String(row.tablename));
    if (names.some(name => !/^[a-z_0-9]+$/.test(name))) throw Error('INVALID_TABLE');
    const protectedTable = (name: string) => ['connections','connection_checks','schema_migrations','worker_heartbeats'].includes(name)
      || name.startsWith('production_') || (name.startsWith('seller_knowledge_') && name !== 'seller_knowledge_draft_acceptances');
    const targets = names.filter(name => !protectedTable(name));
    const links=(await pool.query(`SELECT conrelid::regclass::text AS child,confrelid::regclass::text AS parent FROM pg_constraint WHERE contype='f' AND connamespace=current_schema()::regnamespace`)).rows;
    if (links.some(link => targets.includes(link.parent) && !targets.includes(link.child))) throw Error('PROTECTED_DEPENDENCY');
    const createdAt=new Date().toISOString(), id=createdAt.replace(/[^0-9]/g,'');
    const archiveSchema='workspace_backup_'+id;
    const destination=resolve('.local/workspace-cleanup',id);
    await mkdir(destination,{recursive:true});
    const hiddenBatchIds=(await readdir(resolve('.local/production-batch-pass1-20260915/web-registry'))).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5));
    const hiddenPreparationIds=(await pool.query('SELECT id FROM production_source_preparations')).rows.map(row=>row.id);
    const marker={id,archiveSchema,createdAt,hiddenBatchIds,hiddenPreparationIds};
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='10s'");
      await client.query('LOCK TABLE '+targets.map(name=>'"'+name+'"').join(',')+' IN ACCESS EXCLUSIVE MODE');
      if((await client.query("SELECT 1 FROM source_files WHERE status IN ('queued','running') LIMIT 1")).rowCount) throw Error('IMPORT_STILL_RUNNING');
      if((await client.query("SELECT 1 FROM production_preparation_executions WHERE body->>'state'='running' LIMIT 1")).rowCount) throw Error('PRODUCTION_STILL_RUNNING');
      await client.query(`CREATE SCHEMA "${archiveSchema}"`);
      const report=[];
      for(const name of names) {
        await client.query(`CREATE TABLE "${archiveSchema}"."${name}" AS TABLE public."${name}"`);
        const result=(await client.query(`SELECT (SELECT count(*)::int FROM public."${name}") AS original,(SELECT count(*)::int FROM "${archiveSchema}"."${name}") AS backup`)).rows[0];
        if(result.original!==result.backup)throw Error('BACKUP_COUNT_MISMATCH');
        report.push({table:name,count:result.backup,cleared:targets.includes(name)});
      }
      // Explicit target set, no CASCADE: production receipts, lanes, connections and learned knowledge remain.
      await client.query('TRUNCATE '+targets.map(name=>'"'+name+'"').join(','));
      await writeFile(resolve(destination,'receipt.json'),JSON.stringify({...marker,tables:report},null,2),{flag:'wx'});
      await writeFile(resolve('.local/workspace-reset.pending.json'),JSON.stringify(marker,null,2));
      await client.query('COMMIT');
      await rename(resolve('.local/workspace-reset.pending.json'),resolve('.local/workspace-reset.json'));
      console.log(JSON.stringify({archiveSchema,receipt:resolve(destination,'receipt.json'),clearedTables:targets.length,preserved:'connections, production receipts/guards, knowledge, all filesystem input files'}));
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  } else {
  const counts = [];
  for (const {tablename} of tables) {
    if (!/^[a-z_0-9]+$/.test(tablename)) throw Error('INVALID_TABLE');
    const n = (await pool.query(`SELECT count(*)::int AS n FROM "${tablename}"`)).rows[0].n;
    if (n) counts.push({table:tablename,count:n});
  }
  console.log(JSON.stringify(counts));
  const links=(await pool.query(`SELECT conrelid::regclass::text AS child,confrelid::regclass::text AS parent FROM pg_constraint WHERE contype='f' AND connamespace=current_schema()::regnamespace`)).rows;
  console.log(JSON.stringify(links));
  }
} finally { await pool.end(); }
