// Builds the synthetic claude.ai export fixtures (no real data): conversations.json (the first export), plus
// claude-export.zip and claude-export-newer.zip (a later export: one chat grew, one unanswered message got its answer,
// one chat is new) for checking the import in a browser. Run: node tests/fixtures/claude-export/make.mjs
import { zipSync, strToU8 } from 'fflate';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const m = (uuid, sender, created_at, text, extra = {}) => ({ uuid, sender, created_at, updated_at: created_at, text, content: text ? [{ type: 'text', text }] : [], attachments: [], files: [], ...extra });
export function first() {
  return [
    { uuid: '0f6e1a52-1111-4a1b-9a01-000000000001', name: 'Sourdough starter schedule', summary: '', created_at: '2025-03-02T09:00:00.000000Z', updated_at: '2025-03-02T09:05:00.000000Z', chat_messages: [
      m('a0000000-0000-4000-8000-000000000001', 'human', '2025-03-02T09:00:00.000000Z', 'How often should I feed a rye sourdough starter kept at room temperature?'),
      { ...m('a0000000-0000-4000-8000-000000000002', 'assistant', '2025-03-02T09:00:20.000000Z', ''), text: 'IGNORED plain text (content blocks win)', content: [{ type: 'thinking', thinking: 'Rye ferments fast; warm kitchens speed it up.' }, { type: 'text', text: 'Feed it **twice a day** at room temperature, roughly every 12 hours, at 1:1:1 starter:flour:water.' }] },
      m('a0000000-0000-4000-8000-000000000003', 'human', '2025-03-02T09:04:00.000000Z', 'And if I keep it in the fridge?'),
      m('a0000000-0000-4000-8000-000000000004', 'assistant', '2025-03-02T09:04:30.000000Z', 'In the fridge, once a week is enough. Let it warm up and feed it twice before baking.'),
    ] },
    { uuid: '0f6e1a52-2222-4a1b-9a01-000000000002', name: 'Quarterly planning notes', created_at: '2025-06-10T14:00:00.000000Z', updated_at: '2025-06-10T14:30:00.000000Z', chat_messages: [
      { uuid: 'b0000000-0000-4000-8000-000000000001', sender: 'human', created_at: '2025-06-10T14:00:00.000000Z', text: 'Summarise the attached plan into three priorities for the studio.',
        attachments: [{ file_name: 'q3-plan.txt', file_size: 120, file_type: 'txt', extracted_content: 'Q3: launch the tester programme, ship thread sync, cut video costs by a third.' }], files: [{ file_name: 'whiteboard.png' }] },
      { uuid: 'b0000000-0000-4000-8000-000000000002', sender: 'assistant', created_at: '2025-06-10T14:01:00.000000Z', text: '1. Launch the tester programme\n2. Ship thread sync\n3. Cut video costs by a third' },
      { uuid: 'b0000000-0000-4000-8000-000000000003', sender: 'human', created_at: '2025-06-10T14:30:00.000000Z', text: 'Which of those is riskiest?' },
    ] },
    { uuid: '0f6e1a52-3333-4a1b-9a01-000000000003', name: 'Empty chat', created_at: '2025-07-01T10:00:00.000000Z', updated_at: '2025-07-01T10:00:00.000000Z', chat_messages: [] },
    { uuid: '0f6e1a52-4444-4a1b-9a01-000000000004', name: 'Trip to Lisbon', created_at: '2025-09-20T08:00:00.000000Z', updated_at: '2025-09-20T08:10:00.000000Z', chat_messages: [
      m('c0000000-0000-4000-8000-000000000001', 'assistant', '2025-09-20T08:00:00.000000Z', 'Welcome back! Picking up your Lisbon plans.'),
      m('c0000000-0000-4000-8000-000000000002', 'human', '2025-09-20T08:01:00.000000Z', 'Three days in Lisbon in October: what should I not miss?'),
      { ...m('c0000000-0000-4000-8000-000000000003', 'assistant', '2025-09-20T08:02:00.000000Z', ''), content: [{ type: 'tool_use', name: 'web_search', input: { query: 'Lisbon October events' } }, { type: 'tool_result', content: [{ type: 'text', text: 'search results' }] }, { type: 'text', text: 'Belem and its custard tarts, the Alfama at dusk, and a day trip to Sintra.' }] },
      m('c0000000-0000-4000-8000-000000000004', 'human', '2025-09-20T08:05:00.000000Z', 'Is the tram 28 worth it?'),
      m('c0000000-0000-4000-8000-000000000005', 'human', '2025-09-20T08:06:00.000000Z', 'Sorry, also: best time to visit Sintra?'),
      m('c0000000-0000-4000-8000-000000000006', 'assistant', '2025-09-20T08:10:00.000000Z', 'Tram 28 is fun early in the morning. Go to Sintra on a weekday, arriving before 9.'),
    ] },
    { uuid: '0f6e1a52-5555-4a1b-9a01-000000000005', name: '', created_at: '2024-11-05T18:00:00.000000Z', updated_at: '2024-11-05T18:01:00.000000Z', chat_messages: [
      m('d0000000-0000-4000-8000-000000000001', 'human', '2024-11-05T18:00:00.000000Z', 'Name ideas for a ceramics newsletter'),
      m('d0000000-0000-4000-8000-000000000002', 'assistant', '2024-11-05T18:01:00.000000Z', 'Kiln Notes, Glaze Days, The Wedging Table.'),
    ] },
  ];
}
export function newer() {
  const convs = first();
  const sour = convs[0];
  sour.updated_at = '2025-03-09T10:01:00.000000Z';
  sour.chat_messages.push(m('a0000000-0000-4000-8000-000000000005', 'human', '2025-03-09T10:00:00.000000Z', 'My starter smells like nail polish remover. Is it dead?'),
    m('a0000000-0000-4000-8000-000000000006', 'assistant', '2025-03-09T10:01:00.000000Z', 'Not dead, just hungry: that acetone smell means it needs feeding more often.'));
  const plan = convs[1];
  plan.updated_at = '2025-06-10T14:31:00.000000Z';
  plan.chat_messages.push({ uuid: 'b0000000-0000-4000-8000-000000000004', sender: 'assistant', created_at: '2025-06-10T14:31:00.000000Z', text: 'Thread sync: it touches everyone\'s data.' });
  convs.push({ uuid: '0f6e1a52-6666-4a1b-9a01-000000000006', name: 'Glaze recipe math', created_at: '2025-10-01T12:00:00.000000Z', updated_at: '2025-10-01T12:02:00.000000Z', chat_messages: [
    m('e0000000-0000-4000-8000-000000000001', 'human', '2025-10-01T12:00:00.000000Z', 'Convert a cone 6 glaze recipe from percentages to grams for a 500 g batch.'),
    m('e0000000-0000-4000-8000-000000000002', 'assistant', '2025-10-01T12:02:00.000000Z', 'Multiply each percentage by 5: 20% silica becomes 100 g, and so on.'),
  ] });
  return convs;
}
export const zip = (convs) => zipSync({ 'users.json': strToU8('[{"uuid":"u-synthetic","full_name":"Test Person"}]'), 'conversations.json': strToU8(JSON.stringify(convs, null, 1)), 'projects.json': strToU8('[]') });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = new URL('./', import.meta.url);
  await writeFile(new URL('conversations.json', dir), JSON.stringify(first(), null, 1));
  await writeFile(new URL('claude-export.zip', dir), zip(first()));
  await writeFile(new URL('claude-export-newer.zip', dir), zip(newer()));
  console.log('wrote conversations.json, claude-export.zip, claude-export-newer.zip');
}
