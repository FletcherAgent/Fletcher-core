import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function uploadAgentMetadata(agentId: string, metadata: any): Promise<string> {
  const fileName = `agents/${agentId}.json`;
  const { data, error } = await supabase.storage
    .from('fletcher-registry')
    .upload(fileName, JSON.stringify(metadata, null, 2), {
      contentType: 'application/json',
      upsert: true
    });

  if (error) {
    throw new Error(`Failed to upload to Supabase: ${error.message}`);
  }

  // Get public URL
  const { data: publicUrlData } = supabase.storage
    .from('fletcher-registry')
    .getPublicUrl(fileName);

  return publicUrlData.publicUrl;
}
