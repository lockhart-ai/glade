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

// What to post when you click or press a key in the page, if anything (`window.postOnInput`): how the specs make it
// answer a click with `openTask`, as Nekomata's cats do.
window.postOnInput = null
function answerInput() {
  if (window.postOnInput !== null) window.glade.post(window.postOnInput)
}
document.addEventListener('click', answerInput)
document.addEventListener('keydown', answerInput)

window.glade.post({ type: 'ready' })
