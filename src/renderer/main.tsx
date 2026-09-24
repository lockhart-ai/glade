import { appPage, mountApp } from './mount'
import { ReadySignal } from './ready'
import './global.css'

const root = document.getElementById('root')

// The component gallery is for development only. `import.meta.env.DEV` is `false` in a production build, so the
// bundler drops this branch and the gallery's chunk with it.
if (import.meta.env.DEV && window.location.hash === '#gallery') {
  void import('./gallery/Gallery').then(({ Gallery }) => {
    mountApp(
      root,
      <ReadySignal>
        <Gallery />
      </ReadySignal>,
    )
  })
} else {
  mountApp(root, appPage(window.glade))
}
