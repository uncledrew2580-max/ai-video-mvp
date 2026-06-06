import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const DB = path.join(os.homedir(), '.n8n/database.sqlite');
const WORKFLOW_IDS = ['rKHHjD2QBlL6EhaM', 'conceptSelectStoryboardV1', 'reviewSubmitVeoV2'];

function sql(value) {
  return String(value ?? '').replaceAll("'", "''");
}

function sqlite(query) {
  return execFileSync('sqlite3', [DB, query], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

for (const workflowId of WORKFLOW_IDS) {
  const rows = JSON.parse(
    execFileSync(
      'sqlite3',
      [
        DB,
        '-json',
        `select id,name,active,nodes,connections,versionId,activeVersionId,description from workflow_entity where id='${sql(workflowId)}'`,
      ],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    ) || '[]',
  );
  const workflow = rows[0];
  if (!workflow) {
    console.log(`skip missing workflow ${workflowId}`);
    continue;
  }

  const versionId = workflow.versionId || crypto.randomUUID();
  const exists = JSON.parse(
    execFileSync(
      'sqlite3',
      [DB, '-json', `select versionId from workflow_history where versionId='${sql(versionId)}' limit 1`],
      { encoding: 'utf8' },
    ) || '[]',
  )[0];

  if (!exists) {
    sqlite(
      `insert into workflow_history (versionId,workflowId,authors,nodes,connections,name,autosaved,description,createdAt,updatedAt)
       values ('${sql(versionId)}','${sql(workflow.id)}','codex-stability-repair','${sql(workflow.nodes)}','${sql(workflow.connections)}','${sql(workflow.name)}',0,'${sql(workflow.description || '')}',strftime('%Y-%m-%d %H:%M:%f','now'),strftime('%Y-%m-%d %H:%M:%f','now'));`,
    );
    console.log(`created workflow_history ${workflow.id} -> ${versionId}`);
  } else {
    sqlite(
      `update workflow_history
       set nodes='${sql(workflow.nodes)}',
           connections='${sql(workflow.connections)}',
           name='${sql(workflow.name)}',
           updatedAt=strftime('%Y-%m-%d %H:%M:%f','now')
       where versionId='${sql(versionId)}';`,
    );
    console.log(`updated workflow_history ${workflow.id} -> ${versionId}`);
  }

  if (workflow.active) {
    sqlite(
      `update workflow_entity
       set activeVersionId='${sql(versionId)}',
           updatedAt=strftime('%Y-%m-%d %H:%M:%f','now')
       where id='${sql(workflow.id)}';`,
    );
    sqlite(
      `insert into workflow_published_version (workflowId,publishedVersionId,createdAt,updatedAt)
       values ('${sql(workflow.id)}','${sql(versionId)}',strftime('%Y-%m-%d %H:%M:%f','now'),strftime('%Y-%m-%d %H:%M:%f','now'))
       on conflict(workflowId) do update set
         publishedVersionId=excluded.publishedVersionId,
         updatedAt=strftime('%Y-%m-%d %H:%M:%f','now');`,
    );
    console.log(`repaired activeVersionId ${workflow.id} -> ${versionId}`);
  }
}
