import 'dotenv/config';
import {Pool} from '@shopee/persistence';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
 const rows=(await pool.query(`SELECT o.id,o.source_identity,o.source_revision,o.state,o.item_id,o.revision,
 (SELECT jsonb_agg(jsonb_build_object('key',s.step_key,'state',s.state) ORDER BY s.ordinal) FROM production_pilot_steps s WHERE s.operation_id=o.id) AS steps
 FROM production_pilot_operations o WHERE owner_key=$1 AND source_identity=ANY($2::text[]) ORDER BY o.created_at`,
 ['production:2010476:1423724897',['row-119','row-193','row-194','row-192'].map(k=>'fd983d71-dbe4-4980-a3d6-d2f90d9f117c:'+k)])).rows;
 const cases=(await pool.query(`SELECT id,binding,source_sha256,output_sha256,comparison,fingerprint FROM image_qc_cases WHERE binding->>'operationId'=ANY($1::text[])`,[rows.map(r=>r.id)])).rows;
 console.log(JSON.stringify({observedAt:new Date().toISOString(),operations:rows,imageCases:cases}));
}finally{await pool.end();}
