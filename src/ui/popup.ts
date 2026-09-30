import { Modal, App } from 'obsidian';
export class PopupModal extends Modal {
  constructor(app: App, content: string) {
    super(app);
    this.setTitle('Failure Details');
	this.contentEl.createDiv({ text: content, cls: 'obpb_popup_modal' });
  }
}