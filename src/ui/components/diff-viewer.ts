import { diffLines, Change } from 'diff';

/**
 * Note history -  view one particular version
 */
export class DiffViewer {
    public static renderDiff(containerEl: HTMLElement, oldText: string, newText: string): void {
        containerEl.empty();
        containerEl.addClass('obpb_diff_container');

        const changes: Change[] = diffLines(oldText, newText);

        const pre = containerEl.createEl('pre', { cls: 'obpb_diff_pre' });

        for (const change of changes) {
            const lines = change.value.replace(/\n$/, '').split('\n');

            for (const line of lines) {
                const lineEl = pre.createEl('div', { cls: 'obpb_diff_line' });

                if (change.added) {
                    lineEl.addClass('obpb_diff_added');
                    lineEl.createSpan({ cls: 'obpb_diff_prefix', text: '+ ' });
                    lineEl.createSpan({ cls: 'obpb_diff_text', text: line });
                } else if (change.removed) {
                    lineEl.addClass('obpb_diff_removed');
                    lineEl.createSpan({ cls: 'obpb_diff_prefix', text: '- ' });
                    lineEl.createSpan({ cls: 'obpb_diff_text', text: line });
                } else {
                    lineEl.addClass('obpb_diff_unchanged');
                    lineEl.createSpan({ cls: 'obpb_diff_prefix', text: '  ' });
                    lineEl.createSpan({ cls: 'obpb_diff_text', text: line });
                }
            }
        }
    }
}

/**
 * diffLines functionality
 * 
 * node --input-type=module -e 'import { diffLines } from \"diff\"; let test=\"this\nis\na\ntest\"; let test1 = \"this is a \ntest\";console.log(diffLines(test, test1));'
[
  { count: 3, added: undefined, removed: true, value: 'this\nis\na\n' },
  { count: 1, added: true, removed: undefined, value: 'this is a \n' },
  { count: 1, value: 'test' }
]
 */