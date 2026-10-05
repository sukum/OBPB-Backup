import { Modal, App } from 'obsidian';
export class PopupModal extends Modal {
  constructor(app: App, content: string) {
    super(app);
    this.setTitle('Failure details');
	this.contentEl.createDiv({ text: content, cls: 'pb_popup_modal' });
  }
}