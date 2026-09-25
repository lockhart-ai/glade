/* global window, document */

// Every message from Glade, as it arrived, for the specs to read (`window.received`).
window.received = []

window.addEventListener('message', (event) => {
  const message = event.data
  if (message?.source !== 'glade' || message.apiVersion !== 1) return
  window.received.push(message)
  document.getElementById('waiting').hidden = true
  const item = document.createElement('li')
  item.textContent = JSON.stringify(message)
  document.getElementById('messages').append(item)
  if (message.event.type === 'hello') {
    window.glade.post({ type: 'status', text: `Glade ${message.event.app.version} said hello` })
  }
})

window.glade.post({ type: 'ready' })
