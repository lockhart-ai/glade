import { createErrorReporter, reactErrorOptions, reportWindowErrors } from './errors/reportErrors'
import { appPage, mountApp } from './mount'
import { ReadySignal } from './ready'
import './global.css'

const root = document.getElementById('root')

// The window's errors go to the main log, since this console goes nowhere once the app is packaged.
const report = createErrorReporter(window.glade)
reportWindowErrors(window, report)
const options = reactErrorOptions(report)

// The component gallery is for development only. `import.meta.env.DEV` is `false` in a production build, so the
// bundler drops this branch and the gallery's chunk with it.
if (import.meta.env.DEV && window.location.hash === '#gallery') {
  void import('./gallery/Gallery').then(({ Gallery }) => {
    mountApp(
      root,
      <ReadySignal>
        <Gallery />
      </ReadySignal>,
      options,
    )
  })
} else {
  mountApp(root, appPage(window.glade), options)
}
