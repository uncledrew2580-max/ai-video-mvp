import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_PROMPTS_PATH = path.join(__dirname, 'tiktok-workflow-prompts.json');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const CREATIVE_TASK_TYPE_MAPPING_PATH = path.join(__dirname, 'config', 'creative_task_type_mapping.json');

function readText(fileName) {
  return fs.readFileSync(path.join(PROMPTS_DIR, fileName), 'utf8').trim();
}

export function loadPromptModules() {
  const legacy = JSON.parse(fs.readFileSync(LEGACY_PROMPTS_PATH, 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(CREATIVE_TASK_TYPE_MAPPING_PATH, 'utf8'));

  return {
    ...legacy,
    creative_task_type_mapping: mapping,
    prompt_modules: {
      director_system: readText('00_director_system_prompt.txt'),
      concept_generation: readText('01_concept_generation_prompt.txt'),
      script_table: readText('02_script_table_prompt.txt'),
      nanobanana_storyboard: readText('03_nanobanana_storyboard_prompt.txt'),
      video_clip: readText('04_video_clip_prompt.txt'),
      voiceover: readText('05_voiceover_prompt.txt'),
      negative_prompt_common: readText('negative_prompt_common.txt'),
      consistency_rules: readText('consistency_rules_prompt.txt'),
      localization_rules: readText('localization_rules_prompt.txt')
    }
  };
}
