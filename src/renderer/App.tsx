import styles from './App.module.css'
import { HydrationStatus } from './store/state'
import { useGladeStore } from './store/react'

export function App(): React.JSX.Element {
  const hydration = useGladeStore((state) => state.hydration)
  switch (hydration.status) {
    case HydrationStatus.Loading:
      return (
        <main className={styles.placeholder} aria-busy="true">
          Loading…
        </main>
      )
    case HydrationStatus.Failed:
      return <main className={styles.placeholder}>Glade couldn’t load: {hydration.message}</main>
    case HydrationStatus.Ready:
      return <main className={styles.placeholder}>Glade</main>
  }
}
