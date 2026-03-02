import * as fs from 'fs';

/**
 * .svcignore 文件解析器
 * 支持 gitignore 风格的规则：
 * - # 开头表示注释
 * - ! 开头表示例外（强制下载）
 * - * 通配符
 * - ** 递归通配符
 * - / 结尾表示目录
 */
export class IgnoreParser {
    private rules: IgnoreRule[] = [];

    constructor(ignoreFileContent?: string) {
        if (ignoreFileContent) {
            this.parseRules(ignoreFileContent);
        } else {
            // 默认规则
            this.addDefaultRules();
        }
    }

    private addDefaultRules(): void {
        // 默认忽略常见的大文件和临时文件
        const defaultRules = [
            '# 默认忽略规则',
            '*.pyc',
            '__pycache__/',
            '.git/',
            'node_modules/',
            '*.log',
            '*.tmp',
            '.DS_Store',
            'Thumbs.db',
            '',
            '# 大型数据文件',
            '*.pkl',
            '*.pth',
            '*.pt',
            '*.ckpt',
            '*.h5',
            '*.hdf5',
            '',
            '# 数据集（通常很大）',
            'data/',
            'dataset/',
            'datasets/',
            '',
            '# 例外：允许下载配置文件',
            '!*.json',
            '!*.yaml',
            '!*.yml',
            '!*.toml',
            '!*.ini'
        ];
        this.parseRules(defaultRules.join('\n'));
    }

    private parseRules(content: string): void {
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // 跳过空行和注释
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            const isException = trimmed.startsWith('!');
            const pattern = isException ? trimmed.substring(1) : trimmed;
            const isDirectory = pattern.endsWith('/');
            const cleanPattern = isDirectory ? pattern.slice(0, -1) : pattern;

            this.rules.push({
                pattern: cleanPattern,
                isException,
                isDirectory,
                regex: this.patternToRegex(cleanPattern)
            });
        }
    }

    private patternToRegex(pattern: string): RegExp {
        // 转义特殊字符，但保留 * 和 ?
        let regex = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*')
            .replace(/\?/g, '.');

        // 如果不是以 / 开头，匹配任意路径
        if (!pattern.startsWith('/')) {
            regex = '(^|/)' + regex;
        } else {
            regex = '^' + regex.substring(1);
        }

        return new RegExp(regex + '($|/)');
    }

    /**
     * 检查文件/目录是否应该被忽略
     * @param filePath 文件路径（相对于项目根目录）
     * @param isDirectory 是否为目录
     * @returns true 表示忽略（不下载），false 表示下载
     */
    shouldIgnore(filePath: string, isDirectory: boolean): boolean {
        // 规范化路径
        const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\//, '');

        let ignored = false;

        for (const rule of this.rules) {
            // 如果规则指定了目录，但当前不是目录，跳过
            if (rule.isDirectory && !isDirectory) {
                continue;
            }

            if (rule.regex.test(normalizedPath)) {
                ignored = !rule.isException;
            }
        }

        return ignored;
    }

    /**
     * 从文件加载规则
     */
    static async fromFile(filePath: string): Promise<IgnoreParser> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            return new IgnoreParser(content);
        } catch {
            // 文件不存在，使用默认规则
            return new IgnoreParser();
        }
    }

    /**
     * 从字符串加载规则
     */
    static fromString(content: string): IgnoreParser {
        return new IgnoreParser(content);
    }

    /**
     * 获取默认的 .svcignore 内容
     */
    static getDefaultContent(): string {
        return `# SVC Ignore 规则
# 类似 .gitignore，用于控制哪些文件不下载到本地缓存

# Python 编译文件
*.pyc
__pycache__/
*.pyo
*.pyd

# 版本控制
.git/
.svn/

# 依赖
node_modules/
venv/
env/

# 日志文件
*.log
logs/

# 临时文件
*.tmp
*.temp
*.swp
*.swo
*~

# 系统文件
.DS_Store
Thumbs.db
desktop.ini

# 大型模型文件（按需下载）
*.pkl
*.pth
*.pt
*.ckpt
*.h5
*.hdf5
*.safetensors

# 数据集（通常很大）
data/
dataset/
datasets/
*.zip
*.tar.gz
*.rar

# 媒体文件
*.mp4
*.avi
*.mov
*.mp3
*.wav

# IDE 配置（可选）
.vscode/
.idea/
*.iml

# ========== 例外规则 ==========
# 使用 ! 强制下载某些文件

# 允许配置文件
!*.json
!*.yaml
!*.yml
!*.toml
!*.ini
!*.conf
!*.cfg

# 允许代码文件
!*.py
!*.js
!*.ts
!*.go
!*.java
!*.cpp
!*.c
!*.h

# 允许文档
!*.md
!*.txt
!README
!LICENSE
`;
    }
}

interface IgnoreRule {
    pattern: string;
    isException: boolean;
    isDirectory: boolean;
    regex: RegExp;
}
