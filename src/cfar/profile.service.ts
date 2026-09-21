import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { validateGeometry, WindowGeometry } from './domain/geometry';
import { SEED_PROFILES } from './config/seed-profiles';

export interface RegisteredProfile extends WindowGeometry {
  name: string;
}

/**
 * 具名窗规的内存存取：
 *  - 进程启动时从种子配置载入；
 *  - 运行期可以追加，重启即还原；
 *  - 不落库。
 */
@Injectable()
export class ProfileService {
  private readonly profiles = new Map<string, WindowGeometry>();

  constructor() {
    for (const [name, geometry] of Object.entries(SEED_PROFILES)) {
      // 种子配置本身必须合法；启动时校验一次。
      this.profiles.set(name, validateGeometry(geometry));
    }
  }

  get(name: string): WindowGeometry {
    const geometry = this.profiles.get(name);
    if (geometry === undefined) {
      throw new NotFoundException(`unknown window profile: ${name}`);
    }
    return geometry;
  }

  has(name: string): boolean {
    return this.profiles.has(name);
  }

  register(name: string, rawGeometry: unknown): RegisteredProfile {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ConflictException('profile name must be a non-empty string');
    }
    if (this.profiles.has(name)) {
      throw new ConflictException(`window profile already exists: ${name}`);
    }
    const geometry = validateGeometry(rawGeometry as Partial<WindowGeometry>);
    this.profiles.set(name, geometry);
    return { name, ...geometry };
  }

  list(): RegisteredProfile[] {
    return [...this.profiles.entries()].map(([name, geometry]) => ({ name, ...geometry }));
  }
}
