import domReady from "../dom-ready";

const notifications = [];
const domNodes = domReady.then(() => {
	return {
		template: document.getElementById("notification-template"),
		notifications: document.getElementById("notifications")
	};
});

// "Notification" already exists as a JavaScript object
function HUDNotification(content, duration = 5, styles) {
	this.content = content;
	this.styles = styles;

	domNodes.then((elements) => {
		this.node = elements.template.cloneNode(true);
		this.node.removeAttribute("id");
		let contentNode = this.node.getElementsByClassName("notification-content")[0];
		contentNode.innerText = this.content;
		for (let key in styles) {
			contentNode.style[key] = styles[key];
		}
		elements.notifications.appendChild(this.node);
	});

	if (!isNaN(duration)) {
		this.removalTimeout = setTimeout(() => {
			this.remove();
		}, Math.floor(duration * 1000));
	}

	notifications.push(this);
}

HUDNotification.prototype.remove = function() {
	clearTimeout(this.removalTimeout);
	domNodes.then((elements) => {
		// Fade out
		this.node.style.opacity = 0;

		// Remove node
		setTimeout( () => {
			elements.notifications.removeChild(this.node);
		}, 1000);
	});
};

export { HUDNotification };
