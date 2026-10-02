import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { validateSql } from '../lib/db/query.js';
import { TaskRunner } from '../lib/runtime/tasks.js';

function setup(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sample(id INTEGER, value TEXT);');
  const insert=db.prepare('INSERT INTO sample VALUES (?,?)');
  for(let i=0;i<205;i++)insert.run(i,`value-${i}`);
  db.close();
}

test('SQL scanner accepts one statement and rejects writing or multiple statements',()=>{
  for(const sql of ["SELECT ';' AS text;",'--comment\nSELECT 1','PRAGMA table_info(sample)','PRAGMA integrity_check'])assert.equal(validateSql(sql),undefined,sql);
  for(const sql of ['SELECT 1; DELETE FROM sample','ATTACH DATABASE \'other\' AS x','PRAGMA journal_mode=WAL','PRAGMA writable_schema(1)','INSERT INTO sample VALUES (1,\'x\')','SELECT 1;;'])assert.ok(validateSql(sql),sql);
});

test('real Loader SQLite binds parameters and enforces read-only with capped iteration',async()=>{
  const h=await harness({config:{enabledGroups:['db']}});
  try{
    const path=join(h.workspace,'query.sqlite'); setup(path); const original=await readFile(path);
    const all=await h.call('db_query',{db_path:'query.sqlite',sql:'SELECT * FROM sample ORDER BY id'});
    assert.equal(all.value.ok,true,JSON.stringify(all));assert.equal(all.value.row_count,200);assert.equal(all.value.truncated,true);
    const one=await h.call('db_query',{db_path:'query.sqlite',sql:'SELECT * FROM sample WHERE value=?',params:['value-3']});
    assert.equal(one.value.rows[0].id,3);
    const injected=await h.call('db_query',{db_path:'query.sqlite',sql:'SELECT * FROM sample WHERE value=?',params:["' OR 1=1 --"]});
    assert.equal(injected.value.row_count,0);
    for(const sql of ['DELETE FROM sample','PRAGMA journal_mode=WAL','SELECT 1; DROP TABLE sample']){
      const denied=await h.call('db_query',{db_path:'query.sqlite',sql});assert.equal(denied.value.ok,false);
    }
    assert.deepEqual(await readFile(path),original);
  }finally{await h.dispose();}
});

test('SQLite BigInt and blob use explicit lossless JSON forms',async()=>{
  const h=await harness({config:{enabledGroups:['db']}});
  try{
    const path=join(h.workspace,'query.sqlite');setup(path);
    const result=await h.call('db_query',{db_path:path,sql:"SELECT 9223372036854775807 AS large, X'0102' AS bytes"});
    assert.deepEqual(result.value.rows[0].large,{type:'integer',decimal:'9223372036854775807'});
    assert.deepEqual(result.value.rows[0].bytes,{type:'blob',base64:'AQI=',bytes:2});
  }finally{await h.dispose();}
});

test('long SQLite queries are terminated within Worker budget',async()=>{
  const h=await harness({config:{enabledGroups:['db']}});
  const runner=new TaskRunner();
  try{
    const path=join(h.workspace,'query.sqlite');setup(path);
    await assert.rejects(runner.run({kind:'db',path,sql:'SELECT COUNT(*) FROM sample a, sample b, sample c, sample d',params:[],maxRows:200,maxBytes:4096,timeoutMs:300},new AbortController().signal),/超过/);
  }finally{await runner.dispose();await h.dispose();}
});
